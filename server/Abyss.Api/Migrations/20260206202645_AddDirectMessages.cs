using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDirectMessages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Channels_Servers_ServerId",
                table: "Channels");

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Notifications",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Channels",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AlterColumn<string>(
                name: "Name",
                table: "Channels",
                type: "text",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "text");

            migrationBuilder.AddColumn<string>(
                name: "DmUser1Id",
                table: "Channels",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DmUser2Id",
                table: "Channels",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "LastMessageAt",
                table: "Channels",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Channels_DmUser1Id_DmUser2Id",
                table: "Channels",
                columns: new[] { "DmUser1Id", "DmUser2Id" },
                unique: true,
                filter: "\"DmUser1Id\" IS NOT NULL AND \"DmUser2Id\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Channels_DmUser2Id",
                table: "Channels",
                column: "DmUser2Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Channels_AspNetUsers_DmUser1Id",
                table: "Channels",
                column: "DmUser1Id",
                principalTable: "AspNetUsers",
                principalColumn: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Channels_AspNetUsers_DmUser2Id",
                table: "Channels",
                column: "DmUser2Id",
                principalTable: "AspNetUsers",
                principalColumn: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Channels_Servers_ServerId",
                table: "Channels",
                column: "ServerId",
                principalTable: "Servers",
                principalColumn: "Id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Channels_AspNetUsers_DmUser1Id",
                table: "Channels");

            migrationBuilder.DropForeignKey(
                name: "FK_Channels_AspNetUsers_DmUser2Id",
                table: "Channels");

            migrationBuilder.DropForeignKey(
                name: "FK_Channels_Servers_ServerId",
                table: "Channels");

            migrationBuilder.DropIndex(
                name: "IX_Channels_DmUser1Id_DmUser2Id",
                table: "Channels");

            migrationBuilder.DropIndex(
                name: "IX_Channels_DmUser2Id",
                table: "Channels");

            migrationBuilder.DropColumn(
                name: "DmUser1Id",
                table: "Channels");

            migrationBuilder.DropColumn(
                name: "DmUser2Id",
                table: "Channels");

            migrationBuilder.DropColumn(
                name: "LastMessageAt",
                table: "Channels");

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Notifications",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Channels",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "Name",
                table: "Channels",
                type: "text",
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "text",
                oldNullable: true);

            migrationBuilder.AddForeignKey(
                name: "FK_Channels_Servers_ServerId",
                table: "Channels",
                column: "ServerId",
                principalTable: "Servers",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
